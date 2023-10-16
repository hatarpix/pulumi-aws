package main

import (
	"github.com/pulumi/pulumi-aws/sdk/v4/go/aws/ec2"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {

		// Create an SSH Key Pair
		keyPair, err := ec2.NewKeyPair(ctx, "adminaws", &ec2.KeyPairArgs{
			PublicKey: pulumi.String("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINWO9EKfPEQCbFV9VGl/GCp1cRfEugz/Yr36ch6yKd4p admin"),
		})
		if err != nil {
			return err
		}

		// Create a new VPC
		vpc, err := ec2.NewVpc(ctx, "vpc-dev", &ec2.VpcArgs{
			CidrBlock: pulumi.String("10.90.0.0/16"),
		})
		if err != nil {
			return err
		}

		// Create a tag for the VPC
		_, err = ec2.NewTag(ctx, "vpc-tag", &ec2.TagArgs{
			Key:        pulumi.String("Name"),
			Value:      pulumi.String("vpc-dev"),
			ResourceId: vpc.ID(),
		})
		if err != nil {
			return err
		}

		// Create an Internet Gateway
		igw, err := ec2.NewInternetGateway(ctx, "igw", &ec2.InternetGatewayArgs{
			VpcId: vpc.ID(),
		})
		if err != nil {
			return err
		}

		// Create public subnets in different availability zones
		availabilityZones := []string{"us-east-1a", "us-east-1b", "us-east-1c"}
		for i, az := range availabilityZones {
			subnetCidr := pulumi.Sprintf("10.90.%d.0/24", i)
			subnet, err := ec2.NewSubnet(ctx, "public-subnet-"+az, &ec2.SubnetArgs{
				VpcId:            vpc.ID(),
				CidrBlock:        subnetCidr,
				AvailabilityZone: pulumi.String(az),
				Tags: pulumi.StringMap{
					"Name": pulumi.String("public-subnet-" + az),
				},
			})
			if err != nil {
				return err
			}

			// Associate the subnet with the Internet Gateway
			_, err = ec2.NewRouteTableAssociation(ctx, "public-subnet-rt-assoc-"+az, &ec2.RouteTableAssociationArgs{
				SubnetId:     subnet.ID(),
				RouteTableId: vpc.MainRouteTableId,
			})
			if err != nil {
				return err
			}

			// Create a route that directs traffic to the Internet Gateway
			_, err = ec2.NewRoute(ctx, "internet-route-"+az, &ec2.RouteArgs{
				RouteTableId:         vpc.MainRouteTableId,
				DestinationCidrBlock: pulumi.String("0.0.0.0/0"),
				GatewayId:            igw.ID(),
			})
			if err != nil {
				return err
			}
		}

		sshGroup, err := ec2.NewSecurityGroup(ctx, "ALL_ssh", &ec2.SecurityGroupArgs{
			VpcId: vpc.ID(),
			Name:  pulumi.String("ALL_ssh"),
			Ingress: ec2.SecurityGroupIngressArray{
				&ec2.SecurityGroupIngressArgs{
					Protocol: pulumi.String("tcp"),
					FromPort: pulumi.Int(22),
					ToPort:   pulumi.Int(22),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
			},
			Egress: ec2.SecurityGroupEgressArray{
				&ec2.SecurityGroupEgressArgs{
					Protocol: pulumi.String("-1"), // All protocols
					FromPort: pulumi.Int(0),
					ToPort:   pulumi.Int(0),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
			},
			Tags: pulumi.StringMap{
				"Name": pulumi.String("ALL_ssh"), // Set the Name tag
			},
		})
		if err != nil {
			return err
		}

		k0sGroup, err := ec2.NewSecurityGroup(ctx, "ALL_k0s", &ec2.SecurityGroupArgs{
			VpcId: vpc.ID(),
			Name:  pulumi.String("ALL_k0s"),
			Ingress: ec2.SecurityGroupIngressArray{
				&ec2.SecurityGroupIngressArgs{
					Protocol: pulumi.String("tcp"),
					FromPort: pulumi.Int(6443),
					ToPort:   pulumi.Int(6443),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
				&ec2.SecurityGroupIngressArgs{
					Protocol: pulumi.String("tcp"),
					FromPort: pulumi.Int(8132),
					ToPort:   pulumi.Int(8132),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
				&ec2.SecurityGroupIngressArgs{
					Protocol: pulumi.String("tcp"),
					FromPort: pulumi.Int(9443),
					ToPort:   pulumi.Int(9443),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
			},
			Egress: ec2.SecurityGroupEgressArray{
				&ec2.SecurityGroupEgressArgs{
					Protocol: pulumi.String("-1"), // All protocols
					FromPort: pulumi.Int(0),
					ToPort:   pulumi.Int(0),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
			},
			Tags: pulumi.StringMap{
				"Name": pulumi.String("ALL_k0s"), // Set the Name tag
			},
		})
		if err != nil {
			return err
		}

		httpGroup, err := ec2.NewSecurityGroup(ctx, "ALL_http", &ec2.SecurityGroupArgs{
			VpcId: vpc.ID(),
			Name:  pulumi.String("ALL_http"),
			Ingress: ec2.SecurityGroupIngressArray{
				&ec2.SecurityGroupIngressArgs{
					Protocol: pulumi.String("tcp"),
					FromPort: pulumi.Int(80),
					ToPort:   pulumi.Int(80),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
				&ec2.SecurityGroupIngressArgs{
					Protocol: pulumi.String("tcp"),
					FromPort: pulumi.Int(443),
					ToPort:   pulumi.Int(443),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
			},
			Egress: ec2.SecurityGroupEgressArray{
				&ec2.SecurityGroupEgressArgs{
					Protocol: pulumi.String("-1"), // All protocols
					FromPort: pulumi.Int(0),
					ToPort:   pulumi.Int(0),
					CidrBlocks: pulumi.StringArray{
						pulumi.String("0.0.0.0/0"),
					},
				},
			},
			Tags: pulumi.StringMap{
				"Name": pulumi.String("ALL_http"), // Set the Name tag
			},
		})
		if err != nil {
			return err
		}

		ctx.Export("vpcID", vpc.ID())
		ctx.Export("keyPair", keyPair.ID())
		ctx.Export("sshGroup", sshGroup.ID())
		ctx.Export("k0sGroup", k0sGroup.ID())
		ctx.Export("httpGroup", httpGroup.ID())

		return nil
	})
}